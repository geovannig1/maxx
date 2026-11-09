import { describe, it, expect } from 'vitest'
import { csvCell, buildCsv } from '@/lib/export/csv'

describe('csvCell', () => {
  it('passes through plain values', () => {
    expect(csvCell('hello')).toBe('hello')
    expect(csvCell(42)).toBe('42')
    expect(csvCell(0)).toBe('0')
  })

  it('renders null/undefined as empty', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('quotes and escapes commas, quotes, and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
  })
})

describe('buildCsv', () => {
  it('joins headers and rows with CRLF, escaping as needed', () => {
    const csv = buildCsv(
      ['Name', 'Spend', 'CTR'],
      [
        ['Campaign, A', 1234.5, 1.5],
        ['B', null, 0.8],
      ]
    )
    expect(csv).toBe('Name,Spend,CTR\r\n"Campaign, A",1234.5,1.5\r\nB,,0.8')
  })
})

describe('csvCell formula-injection safety', () => {
  // A cell a spreadsheet would evaluate (= + - @, or a leading tab/CR) is exported as text: prefixed
  // with an apostrophe and quoted. Imported outcome labels and Meta names are free text.
  it.each([
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
    ['+SUM(1,2)', `"'+SUM(1,2)"`],
    ['-2+3', `"'-2+3"`],
    ['@cmd', `"'@cmd"`],
    ['\t=1', `"'\t=1"`],
    ['\r=1', `"'\r=1"`],
    [' =1', `"' =1"`],
    ['﻿=1', `"'﻿=1"`],
  ])('neutralizes %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected)
  })

  it('leaves numbers and ordinary text alone (controls)', () => {
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell(-0.5)).toBe('-0.5')
    expect(csvCell('Spring sale')).toBe('Spring sale')
    expect(csvCell('a=b')).toBe('a=b')
    expect(csvCell('email@example.test')).toBe('email@example.test')
  })
})
