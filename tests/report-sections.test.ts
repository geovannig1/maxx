import { describe, it, expect } from 'vitest'
import { parseReportSections, sectionTone } from '@/lib/report/report-sections'

describe('parseReportSections', () => {
  it('splits on ## / ### headings and keeps bodies', () => {
    const md = `## Winners\nAd A held CPA at $48.\n\n## What to watch\nFrequency creeping on Ad B.`
    const s = parseReportSections(md)
    expect(s).toHaveLength(2)
    expect(s[0].title).toBe('Winners')
    expect(s[0].body).toContain('$48')
    expect(s[1].title).toBe('What to watch')
  })

  it('treats a standalone bold line as a heading', () => {
    const s = parseReportSections(`**Summary**\nSpend up 10%.\n**Next steps:**\nRefresh Ad B.`)
    expect(s.map((x) => x.title)).toEqual(['Summary', 'Next steps'])
    expect(s[1].body).toBe('Refresh Ad B.')
  })

  it('keeps preamble before the first heading as a null-title section', () => {
    const s = parseReportSections(`Overall a steady day.\n\n## Winners\nAd A.`)
    expect(s[0].title).toBeNull()
    expect(s[0].body).toBe('Overall a steady day.')
    expect(s[1].title).toBe('Winners')
  })

  it('returns [] for empty/blank input', () => {
    expect(parseReportSections('')).toEqual([])
    expect(parseReportSections(null)).toEqual([])
    expect(parseReportSections('   \n  ')).toEqual([])
  })
})

describe('sectionTone', () => {
  it('reads good / warn / bad from the title, default otherwise', () => {
    expect(sectionTone('Winners')).toBe('good')
    expect(sectionTone('What to watch')).toBe('warn')
    expect(sectionTone('Losers to cut')).toBe('bad')
    expect(sectionTone('Account overview')).toBe('default')
  })
})
