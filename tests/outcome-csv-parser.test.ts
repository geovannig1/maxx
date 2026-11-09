import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/outcomes/adapters/csv/parse'

// RFC 4180 parsing for the outcome CSV import. A record is reported with the
// spreadsheet row it starts on (header = row 1), so an error can name a row the owner can find.

const ok = (text: string) => {
  const result = parseCsv(text)
  if (!result.ok) throw new Error(`expected ok, got ${result.error} at row ${result.row}`)
  return result.records.map((r) => r.fields)
}

describe('parseCsv: records and fields', () => {
  it('splits plain fields and records (control)', () => {
    expect(ok('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('accepts CRLF, LF and a missing final line break identically', () => {
    expect(ok('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
    expect(ok('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
    expect(ok('a,b\r\n1,2')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('strips a UTF-8 byte-order mark from the first header only', () => {
    expect(ok('﻿a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']])
    expect(ok('a,b\n﻿1,2')[1][0]).toBe('﻿1')
  })

  it('keeps empty fields, including leading and trailing ones', () => {
    expect(ok('a,b,c\n,,\n1,,3')).toEqual([['a', 'b', 'c'], ['', '', ''], ['1', '', '3']])
  })

  it('reads quoted fields with embedded commas, quotes and line breaks', () => {
    const records = ok('a,b,c\n"x, y","say ""hi""","line1\r\nline2\nline3"\n')
    expect(records[1]).toEqual(['x, y', 'say "hi"', 'line1\r\nline2\nline3'])
  })

  it('reads an empty quoted field as an empty string', () => {
    expect(ok('a,b\n"",1')).toEqual([['a', 'b'], ['', '1']])
  })

  it('skips blank lines but keeps a record with one empty quoted field', () => {
    expect(ok('a\n\n1\n\n')).toEqual([['a'], ['1']])
  })

  it('reports the spreadsheet row of each record, counting a multi-line quoted record as one row', () => {
    const result = parseCsv('a,b\n"1\n2",x\n3,y\n')
    expect(result.ok && result.records.map((r) => r.row)).toEqual([1, 2, 3])
  })

  it('counts a skipped blank line as a row, as a spreadsheet shows it', () => {
    const result = parseCsv('a\n\n1\r\n\r\n2\n')
    expect(result.ok && result.records.map((r) => r.row)).toEqual([1, 3, 5])
  })
})

describe('parseCsv: refusals', () => {
  it.each([
    ['unterminated quote', 'a,b\n"open,1\n', 'unterminated_quote', 2],
    ['text after a closing quote', 'a,b\n"x"y,1\n', 'invalid_quote', 2],
    ['a quote inside an unquoted field', 'a,b\n1,ab"c\n', 'invalid_quote', 2],
  ])('refuses %s and names the row', (_name, text, error, row) => {
    const result = parseCsv(text)
    expect(result).toMatchObject({ ok: false, error, row })
  })

  it('refuses binary content (a NUL byte), e.g. a spreadsheet file instead of CSV', () => {
    expect(parseCsv('a,b\n1,\u00002')).toMatchObject({ ok: false, error: 'binary_content' })
  })

  it('refuses an empty file', () => {
    expect(parseCsv('')).toMatchObject({ ok: false, error: 'empty_file' })
    expect(parseCsv('﻿\r\n')).toMatchObject({ ok: false, error: 'empty_file' })
  })

  it('stops at the record limit instead of reading an unbounded file', () => {
    const text = 'a\n' + '1\n'.repeat(10)
    expect(parseCsv(text, { maxRecords: 5 })).toMatchObject({ ok: false, error: 'too_many_rows' })
    expect(parseCsv(text, { maxRecords: 11 }).ok).toBe(true)
  })
})

describe('parseCsv: round trip property', () => {
  // Any grid of strings, written the RFC 4180 way, reads back exactly.
  const ALPHABET = ['a', 'Z', '0', ' ', ',', '"', '\n', '\r\n', 'é', '=', '']
  function grid(seed: number): string[][] {
    let s = seed
    const rand = (n: number) => { s = (s * 1103515245 + 12345) % 2 ** 31; return s % n }
    const cols = 1 + rand(4)
    return Array.from({ length: 1 + rand(5) }, () => Array.from({ length: cols }, () =>
      Array.from({ length: rand(5) }, () => ALPHABET[rand(ALPHABET.length)]).join('')))
  }
  const write = (rows: string[][]) => rows.map((r) => r.map((f) => `"${f.replaceAll('"', '""')}"`).join(',')).join('\r\n')

  it('reads back 300 random grids exactly', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rows = grid(seed)
      expect(ok(write(rows)), `seed ${seed}`).toEqual(rows)
    }
  })
})
