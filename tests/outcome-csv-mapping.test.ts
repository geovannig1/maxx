import { describe, expect, it } from 'vitest'
import { readOutcomeCsv } from '@/lib/outcomes/adapters/csv/read'
import { CSV_COLUMNS, CSV_TEMPLATE, MAX_CSV_ROWS } from '@/lib/outcomes/adapters/csv/contract'

const LOCALE = { timezone: 'America/New_York', currency: 'USD' }
const HEADER = 'external_id,outcome_type,status,occurred_at'
const read = (text: string, locale = LOCALE) => readOutcomeCsv(text, locale)
const rowsOf = (text: string) => {
  const r = read(text)
  if (!r.ok) throw new Error(`file error ${r.fileError.code}`)
  return r
}

describe('CSV column contract', () => {
  it('names the required columns and documents every column', () => {
    expect(CSV_COLUMNS.filter((c) => c.required).map((c) => c.name)).toEqual(['external_id', 'outcome_type', 'status', 'occurred_at'])
    expect(CSV_COLUMNS.map((c) => c.name)).toEqual([
      'external_id', 'outcome_type', 'status', 'occurred_at', 'currency', 'gross_value', 'collected_value',
      'fulfilment_at', 'origin', 'outcome_label', 'fbclid', 'gclid', 'utm_source', 'utm_medium', 'utm_campaign',
      'utm_content', 'utm_term', 'landing_page', 'referrer',
    ])
    for (const column of CSV_COLUMNS) expect(column.description.length, column.name).toBeGreaterThan(10)
  })

  it('ships a template that imports cleanly (control for every rule below)', () => {
    const r = rowsOf(CSV_TEMPLATE)
    expect(r.errors).toEqual([])
    expect(r.rows.length).toBeGreaterThan(0)
  })
})

describe('readOutcomeCsv: headers', () => {
  it('matches headers case-insensitively and ignores surrounding spaces', () => {
    const r = rowsOf(' External_ID ,OUTCOME_TYPE,Status,Occurred_At\nA1,lead,confirmed,2026-07-01T10:00:00Z')
    expect(r.rows[0].outcome.externalId).toBe('A1')
  })

  it('refuses a file missing a required column and names it', () => {
    const r = read('external_id,outcome_type,status\nA1,lead,confirmed')
    expect(r).toMatchObject({ ok: false, fileError: { code: 'missing_columns', columns: ['occurred_at'] } })
  })

  it('refuses an unknown column by position (never echoing the header text)', () => {
    const r = read(`${HEADER},customer_email\nA1,lead,confirmed,2026-07-01,someone@example.test`)
    expect(r).toMatchObject({ ok: false, fileError: { code: 'unknown_columns', positions: [5] } })
    expect(JSON.stringify(r)).not.toContain('customer_email')
    expect(JSON.stringify(r)).not.toContain('someone@example.test')
  })

  it('refuses a repeated column', () => {
    expect(read('external_id,EXTERNAL_ID,outcome_type,status,occurred_at\n1,2,lead,confirmed,2026-07-01'))
      .toMatchObject({ ok: false, fileError: { code: 'duplicate_columns', columns: ['external_id'] } })
  })

  it('refuses a header-only file and passes parser errors through with their row', () => {
    expect(read(HEADER)).toMatchObject({ ok: false, fileError: { code: 'no_rows' } })
    expect(read(`${HEADER}\n"A1,lead,confirmed,2026-07-01`)).toMatchObject({ ok: false, fileError: { code: 'unterminated_quote', row: 2 } })
  })

  it('refuses more than the row limit', () => {
    const body = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `R${i},lead,confirmed,2026-07-01`).join('\n')
    expect(read(`${HEADER}\n${body}`)).toMatchObject({ ok: false, fileError: { code: 'too_many_rows' } })
  })
})

describe('readOutcomeCsv: field mapping', () => {
  it('maps every column to the generic outcome', () => {
    const header = CSV_COLUMNS.map((c) => c.name).join(',')
    const r = rowsOf(`${header}\nORD-1,Sale,CONFIRMED,2026-07-01T23:30:00-04:00,usd,120.50,100,2026-07-08,website,Gift card,fbc1,gc1,ig,paid,spring,v1,t1,https://shop.example/p,https://ref.example/`)
    expect(r.rows[0]).toEqual({
      row: 2,
      outcome: {
        externalId: 'ORD-1', outcomeType: 'sale', outcomeLabel: 'Gift card', status: 'confirmed', currency: 'USD',
        grossValue: '120.5', collectedValue: '100', occurredAt: '2026-07-02T03:30:00.000Z',
        fulfilmentAt: '2026-07-08T04:00:00.000Z', fulfilmentStatus: null, origin: 'website',
        attribution: {
          fbclid: 'fbc1', fbc: null, fbp: null, gclid: 'gc1', utmSource: 'ig', utmMedium: 'paid', utmCampaign: 'spring',
          utmContent: 'v1', utmTerm: 't1', landingPage: 'https://shop.example/p', referrer: 'https://ref.example/',
        },
        customer: { email: null, phone: null, firstName: null, lastName: null },
        conversionEventId: null, sourceUpdatedAt: null,
      },
    })
  })

  it('defaults: empty money is NULL, empty currency is the account currency, empty origin is unknown', () => {
    const r = rowsOf(`${HEADER},currency,gross_value,collected_value,origin\nA1,lead,pending,2026-07-01,,,0,`)
    expect(r.rows[0].outcome).toMatchObject({ currency: 'USD', grossValue: null, collectedValue: '0', origin: 'unknown', outcomeLabel: null })
  })

  it('interprets date-only values in the configured business timezone', () => {
    expect(rowsOf(`${HEADER}\nA1,lead,confirmed,2026-07-01`).rows[0].outcome.occurredAt).toBe('2026-07-01T04:00:00.000Z')
    const berlin = readOutcomeCsv(`${HEADER}\nA1,lead,confirmed,2026-07-01`, { timezone: 'Europe/Berlin', currency: 'EUR' })
    expect(berlin.ok && berlin.rows[0].outcome.occurredAt).toBe('2026-06-30T22:00:00.000Z')
  })
})

describe('readOutcomeCsv: per-row validation', () => {
  const errorsOf = (line: string, extraHeader = '') => rowsOf(`${HEADER}${extraHeader}\n${line}`).errors

  it.each([
    ['', 'lead,confirmed,2026-07-01', 'external_id', 'required'],
    [' A1', 'lead,confirmed,2026-07-01', 'external_id', 'text_whitespace'],
    ['A1', 'purchase,confirmed,2026-07-01', 'outcome_type', 'invalid_choice'],
    ['A1', 'lead,done,2026-07-01', 'status', 'invalid_choice'],
    ['A1', 'lead,confirmed,', 'occurred_at', 'required'],
    ['A1', 'lead,confirmed,07/01/2026', 'occurred_at', 'date_invalid'],
    ['A1', 'lead,confirmed,2026-07-01T10:00:00', 'occurred_at', 'datetime_missing_offset'],
  ])('row "%s,%s": %s → %s', (id, rest, field, code) => {
    expect(errorsOf(`${id},${rest}`)).toEqual([expect.objectContaining({ row: 2, field, code })])
  })

  it.each([
    [',currency', ',EURO', 'currency', 'currency_invalid'],
    [',currency', ',EUR', 'currency', 'currency_not_account'],
    [',gross_value', ',"1,200.00"', 'gross_value', 'decimal_separator'],
    [',collected_value', ',-5', 'collected_value', 'decimal_negative'],
    [',origin', ',web', 'origin', 'invalid_choice'],
    [',fulfilment_at', ',tomorrow', 'fulfilment_at', 'date_invalid'],
    [',outcome_label', `,${'x'.repeat(257)}`, 'outcome_label', 'text_too_long'],
    [',utm_source', ',"a\nb"', 'utm_source', 'text_control_characters'],
  ])('optional column %s with a bad value is a row error on that field', (extra, value, field, code) => {
    expect(errorsOf(`A1,lead,confirmed,2026-07-01${value}`, extra)).toEqual([expect.objectContaining({ row: 2, field, code })])
  })

  it('reports a row with the wrong number of cells', () => {
    expect(errorsOf('A1,lead,confirmed')).toEqual([expect.objectContaining({ row: 2, field: null, code: 'column_count' })])
  })

  it('marks every row sharing an external_id invalid, naming the other row', () => {
    const r = rowsOf(`${HEADER}\nA1,lead,confirmed,2026-07-01\nB1,lead,confirmed,2026-07-01\nA1,sale,confirmed,2026-07-02`)
    expect(r.rows.map((x) => x.outcome.externalId)).toEqual(['B1'])
    expect(r.errors).toEqual([
      expect.objectContaining({ row: 2, field: 'external_id', code: 'duplicate_external_id' }),
      expect.objectContaining({ row: 4, field: 'external_id', code: 'duplicate_external_id' }),
    ])
    expect(r.invalidRows).toBe(2)
  })

  it('collects every error of a row and keeps valid rows', () => {
    const r = rowsOf(`${HEADER},gross_value\nA1,nope,maybe,2026-07-01,1.5\nA2,lead,confirmed,2026-07-01,2`)
    expect(r.errors.map((e) => [e.row, e.field])).toEqual([[2, 'outcome_type'], [2, 'status']])
    expect(r.rows.map((x) => x.row)).toEqual([3])
    expect(r.totalRows).toBe(2)
  })

  it('never puts a cell value into an error', () => {
    const personal = 'jane.doe@example.test'
    const r = rowsOf(`${HEADER},gross_value,utm_source\n${personal},${personal},${personal},${personal},${personal},"${personal}\n"`)
    expect(r.errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(r.errors)).not.toContain('jane')
  })
})

describe('readOutcomeCsv: money ceiling', () => {
  const MONEY = 'external_id,outcome_type,status,occurred_at,gross_value,collected_value'
  it('refuses a value above the default ceiling and accepts one at it', () => {
    const r = read(`${MONEY}\nA1,sale,confirmed,2026-07-01,1000000000.5,\nA2,sale,confirmed,2026-07-01,,1000000000`)
    if (!r.ok) throw new Error('file error')
    expect(r.errors).toEqual([expect.objectContaining({ row: 2, field: 'gross_value', code: 'decimal_above_ceiling' })])
    expect(r.invalidRows).toBe(1)
    expect(r.rows.map((x) => x.outcome.externalId)).toEqual(['A2'])
  })
})
