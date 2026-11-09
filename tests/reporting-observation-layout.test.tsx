import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { deriveExpertReview } from '@/lib/reporting/review'
import { validateSavedReview } from '@/lib/reporting/saved-review'
import { ReviewObservation } from '@/components/reporting/ReviewObservation'
import type { ReviewObservation as Observation } from '@/lib/reporting/review/contracts'
import { verifyFindingReferences } from '@/lib/reporting/review/evidence'
import { mediaMovementFixture } from './reporting-browser/media-movement-fixture'
import { executiveAnswerFixture, EXECUTIVE_ANSWER_MODES } from './reporting-browser/executive-answer-fixture'

const ids = ['business_platform_trend', 'advertising.allocation']
describe('lossless executive observation sections', () => {
  it.each(EXECUTIVE_ANSWER_MODES)('retains every original fact and qualification in the %s scenario', mode => {
    const data = executiveAnswerFixture(undefined, undefined, mode), review = deriveExpertReview(data)
    for (const finding of review.findings.filter(row => ids.includes(row.id))) {
      expect(finding.observation.sections?.length).toBeGreaterThan(0)
      expect(finding.observation.sections!.flatMap(row => row.paragraphs).join(' ')).toBe(finding.observation.text)
    }
    expect(validateSavedReview(review, data)).toEqual(review)
  })

  it('keeps five separate campaign fields with both named opposing contributors and local reconciliation', () => {
    const data = mediaMovementFixture(), review = deriveExpertReview(data)
    const finding = review.findings.find(row => row.id === 'advertising.allocation')!
    const value = finding.observation.sections!.find(row => row.heading === 'AppointmentConfirmed value')!
    expect(value.paragraphs.join(' ')).toContain('current $1,500 (3/3 campaigns)')
    expect(value.paragraphs.join(' ')).toContain('prior $1,600 (3/3 campaigns)')
    expect(value.paragraphs.join(' ')).toContain('matches the supplied account field')
    expect(value.paragraphs.join(' ')).toContain('Largest gain: Larger campaign (+$200)')
    expect(value.paragraphs.join(' ')).toContain('Largest loss: Smaller loss (-$200)')
    for (const heading of ['Meta spend', 'AppointmentConfirmed count', 'AppointmentConfirmed value', 'Purchase count', 'Purchase value', 'Account efficiency']) {
      expect(finding.observation.sections!.some(row => row.heading === heading)).toBe(true)
    }
  })

  it.each(['altered', 'omitted', 'duplicated', 'reordered'] as const)('rejects %s section text instead of contradicting saved evidence', change => {
    const data = mediaMovementFixture(), review = deriveExpertReview(data)
    const finding = review.findings.find(row => row.id === 'advertising.allocation')!
    const sections = finding.observation.sections!
    if (change === 'altered') sections[1].paragraphs[0] = 'Everything improved; no issue requires attention.'
    if (change === 'omitted') sections.splice(1, 1)
    if (change === 'duplicated') sections.push(sections[1])
    if (change === 'reordered') sections.reverse()
    expect(() => validateSavedReview(review, data)).toThrow('could not be validated')
    const html = renderToStaticMarkup(<ReviewObservation observation={finding.observation} />)
    expect(html).not.toContain('Everything improved')
    expect(html).toContain('Largest loss: Smaller loss (-$200)')
  })

  it('keeps punctuation in long entity names inside the prepared metric row', () => {
    const data = mediaMovementFixture()
    const name = 'Smaller loss: Meta spend; Account efficiency: '.repeat(8)
    data.meta.data!.entities.find(row => row.id === 'small')!.name = name
    const review = deriveExpertReview(data), finding = review.findings.find(row => row.id === 'advertising.allocation')!
    expect(finding.observation.sections).toHaveLength(7)
    expect(finding.observation.sections![3].paragraphs.join(' ')).toContain(`Largest loss: ${name} (-$200)`)
    expect(validateSavedReview(review, data)).toEqual(review)
    expect(renderToStaticMarkup(<ReviewObservation observation={finding.observation} />)).toContain(name)
  })

  it('accepts an older saved version without adding current presentation metadata', () => {
    const data = mediaMovementFixture(), review = deriveExpertReview(data)
    const old = { ...review, playbookVersion: 'maxx-diagnostic-2026-09-07.v10', findings: review.findings.map(row => {
      const observation = { text: row.observation.text, evidence: row.observation.evidence }
      return { ...row, observation }
    }) }
    expect(validateSavedReview(old, data)).toEqual(old)
  })

  it('renders original older saved text without inventing sections or hiding detail', () => {
    const observation = { text: 'Original saved interpretation. Preserve the specific limitation.', evidence: [] }
    const html = renderToStaticMarkup(<ReviewObservation observation={observation} />)
    expect(html).toContain(observation.text)
    expect(html).not.toContain('data-observation-section')
    expect(html).not.toMatch(/line-clamp|<details|hidden/)
  })

  it.each(['invalid', [null], [{ paragraphs: 'Original' }], [{ paragraphs: [null] }],
    [{ heading: 'Verified business profit', paragraphs: ['Original'] }]].map(sections => ({ sections })))('falls back safely for malformed runtime presentation $sections', ({ sections }) => {
    const observation = { text: 'Original', evidence: [], sections } as unknown as Observation
    const html = renderToStaticMarkup(<ReviewObservation observation={observation} />)
    expect(html).toContain('Original'); expect(html).not.toContain('data-observation-section')
    expect(html).not.toContain('Verified business profit')
    const data = mediaMovementFixture(), review = deriveExpertReview(data), finding = review.findings[0]
    expect(() => verifyFindingReferences(data, { ...finding, observation })).toThrow('presentation')
  })
})
