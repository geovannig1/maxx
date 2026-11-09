import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExpertReviewPanel } from '@/components/reporting/ExpertReviewPanel'
import { SavedReportProvider } from '@/components/reporting/SavedReportContext'
import { SavedViewSchema, type OpenSavedReportingReportReply } from '@/lib/reporting/saved-contract'
import { deriveExpertReview, overviewFindings } from '@/lib/reporting/review'
import { performanceGroups } from '@/lib/reporting/review/performance-selection'
import { executiveAnswerFixture } from './reporting-browser/executive-answer-fixture'

const navigation = vi.hoisted(() => ({ search: '' }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(navigation.search), usePathname: () => '/reports' }))
const data = () => executiveAnswerFixture(undefined, undefined, 'stable')
const review = () => deriveExpertReview(data())
const ids = (html: string) => [...html.matchAll(/data-review-id="([^"]+)"/g)].map(match => match[1])
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://maxx.test'))
beforeEach(() => { navigation.search = '' })

describe('complete performance discovery', () => {
  it('opens lower-spend zero-event members even when a higher-spend member takes the highlight', () => {
    const prepared = review(), highlights = overviewFindings(prepared)
    expect(highlights.some(row => row.id === 'performance:adset:set-3')).toBe(true)
    expect(highlights.some(row => row.id === 'performance:adset:set-7')).toBe(false)
    const html = renderToStaticMarkup(<ExpertReviewPanel review={prepared} />)
    const link = links(html).find(url => url.searchParams.get('review_level') === 'adset' && url.searchParams.get('review_signal') === 'zero_outcome')
    expect(link).toBeDefined()
    navigation.search = link!.search
    const filtered = renderToStaticMarkup(<ExpertReviewPanel review={prepared} expanded />)
    expect(ids(filtered)).toEqual(['performance:adset:set-3', 'performance:adset:set-4', 'performance:adset:set-5', 'performance:adset:set-6', 'performance:adset:set-7'])
    expect(filtered).toContain('zero Purchase')
    expect(ids(filtered)).not.toContain('performance:adset:set-10')
    expect(ids(filtered)).not.toContain('performance:adset:set-9')
    expect(link!.searchParams.get('from')).toBe('2026-08-19')
    expect(link!.hash).toBe('#full-assessments')
  })

  it('finds the smaller improvement without summing its campaign or ad into its level', () => {
    navigation.search = 'review_level=adset&review_signal=improved'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={review()} expanded />))).toEqual(['performance:adset:set-8'])
    navigation.search = 'review_level=adset&review_signal=all'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={review()} expanded />))).toHaveLength(10)
    navigation.search = 'review_level=adset&review_signal=improved&review_q=Audience+1'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={review()} expanded />))).toEqual([])
    navigation.search = 'review_level=adset&review_signal=unknown'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={review()} expanded />))).toEqual([])
  })

  it('keeps saved classifications original and excludes unavailable claims from directional groups', () => {
    const prepared = review()
    // Historical replies retain a compatible original version after saved validation;
    // the builder's public type is narrower and names only the current playbook.
    const original = { ...prepared, playbookVersion: 'maxx-diagnostic-2026-09-06.v8' as typeof prepared.playbookVersion, findings: prepared.findings.map(row =>
      row.id === 'performance:adset:set-8' ? { ...row, direction: undefined } : row) }
    navigation.search = 'review_level=adset&review_signal=improved'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={original} expanded />))).toEqual([])
    const unavailable = { ...prepared, findings: prepared.findings.map(row => ({ ...row, status: 'unavailable' as const })) }
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={unavailable} expanded />))).toEqual([])
    navigation.search = ''
    const saved = { saved: { id: 'original-report' } } as OpenSavedReportingReportReply
    const html = renderToStaticMarkup(<SavedReportProvider value={saved}><ExpertReviewPanel review={original} /></SavedReportProvider>)
    const indexed = links(html).filter(url => url.searchParams.has('review_signal'))
    expect(indexed).toHaveLength(15)
    expect(indexed.every(url => url.searchParams.get('saved') === 'original-report')).toBe(true)
    expect(html).toContain('An entity can appear in both')
  })

  it('preserves saved view selection while rejecting an unrelated view key', () => {
    const view = { pathname: '/reports', query: { review_level: 'adset', review_signal: 'zero_outcome' }, hash: '#full-assessments' }
    expect(SavedViewSchema.safeParse(view).success).toBe(true)
    expect(SavedViewSchema.safeParse({ pathname: '/dashboard', query: { overview_event: 'purchase', from: '2026-09-02', to: '2026-09-04' } }).success).toBe(true)
    expect(SavedViewSchema.safeParse({ ...view, query: { ...view.query, unknown_key: 'bad' } }).success).toBe(false)
  })

  it('keeps mixed changes separate from pure improvement and makes zero-event overlap explicit', () => {
    const original = review().findings.find(row => row.id === 'performance:adset:set-3')!
    const mixed = { ...original, direction: 'mixed' as const }
    const groups = performanceGroups([mixed])
    expect(groups.find(group => group.level === 'adset')!.counts).toEqual({ all: 1, zero_outcome: 1, declined: 0, mixed: 1, improved: 0 })
    expect(groups.filter(group => group.level !== 'adset').map(group => group.counts.all)).toEqual([0, 0])
    navigation.search = 'review_signal=mixed'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={{ ...review(), findings: [mixed] }} expanded />))).toEqual([mixed.id])
    navigation.search = 'review_signal=improved'
    expect(ids(renderToStaticMarkup(<ExpertReviewPanel review={{ ...review(), findings: [mixed] }} expanded />))).toEqual([])
    const missing = renderToStaticMarkup(<ExpertReviewPanel review={{ ...review(), findings: [] }} />)
    expect(missing).toContain('Entity-level performance assessments were not supplied')
    expect(links(missing).some(url => url.searchParams.has('review_signal'))).toBe(false)
  })
})
