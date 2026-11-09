import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { CsvImportPanel, commitUrl, previewUrl } from '@/components/outcomes/CsvImportPanel'
import { CsvImportPreview, type CsvPreviewBody } from '@/components/outcomes/CsvImportPreview'

const SOURCE = { id: '00000000-0000-4000-8000-000000000001', label: 'Shop orders', enabled: true, lastSuccessAt: null }

function preview(over: Partial<CsvPreviewBody> = {}): CsvPreviewBody {
  return {
    ok: true,
    file: { sha256: 'a'.repeat(64), bytes: 120 },
    timezone: 'America/New_York',
    counts: { total: 3, new: 1, changed: 1, unchanged: 1, invalid: 0 },
    errors: [],
    errors_truncated: false,
    rows: [
      { row: 2, status: 'new', external_id: 'A1', outcome_type: 'sale', outcome_status: 'confirmed', occurred_at: '2026-07-01T04:00:00.000Z', currency: 'USD', gross_value: null, collected_value: '0', origin: 'website', outcome_label: '<script>x</script>' },
      { row: 3, status: 'changed', external_id: 'A2', outcome_type: 'lead', outcome_status: 'pending', occurred_at: '2026-07-02T04:00:00.000Z', currency: 'USD', gross_value: '120.5', collected_value: null, origin: 'unknown', outcome_label: null },
      { row: 4, status: 'unchanged', external_id: 'A3', outcome_type: 'lead', outcome_status: 'pending', occurred_at: '2026-07-03T04:00:00.000Z', currency: 'USD', gross_value: null, collected_value: null, origin: 'unknown', outcome_label: null },
    ],
    rows_truncated: false,
    ...over,
  }
}

describe('CSV import panel', () => {
  it('labels every control, describes the file input and offers the template download', () => {
    const html = renderToStaticMarkup(<CsvImportPanel sources={[]} />)
    expect(html).toMatch(/<label[^>]*for="csv-file"/)
    expect(html).toMatch(/<input[^>]*id="csv-file"[^>]*type="file"|<input[^>]*type="file"[^>]*id="csv-file"/)
    expect(html).toMatch(/id="csv-file"[^>]*aria-describedby="csv-file-hint"|aria-describedby="csv-file-hint"[^>]*id="csv-file"/)
    expect(html).toMatch(/<label[^>]*for="csv-source-label"/)
    expect(html).toContain('download="maxx-outcomes-template.csv"')
    expect(html).toContain(`href="data:text/csv;charset=utf-8,${encodeURIComponent('external_id,outcome_type')}`)
    // With no CSV source yet, the only choice is a new one: no source picker.
    expect(html).not.toContain('id="csv-source"')
    expect(html).not.toContain('type="radio"')
    // The column contract is on the page: required columns are marked.
    expect(html).toContain('occurred_at')
    expect(html.match(/Required/g)?.length).toBeGreaterThanOrEqual(4)
  })

  it('offers existing csv sources by name', () => {
    const html = renderToStaticMarkup(<CsvImportPanel sources={[SOURCE]} />)
    expect(html).toContain('Shop orders')
    expect(html).toContain(`value="${SOURCE.id}"`)
  })

  it('builds the preview and commit requests for both destinations', () => {
    expect(previewUrl({ mode: 'existing', sourceId: SOURCE.id, label: '', enabled: true }))
      .toBe(`/api/outcomes/csv-imports/preview?source=${SOURCE.id}`)
    expect(previewUrl({ mode: 'new', sourceId: '', label: 'Shop & co', enabled: true }))
      .toBe('/api/outcomes/csv-imports/preview?label=Shop+%26+co')
    expect(commitUrl({ mode: 'new', sourceId: '', label: 'Shop & co', enabled: false }, 'b'.repeat(64)))
      .toBe(`/api/outcomes/csv-imports/commit?sha256=${'b'.repeat(64)}&label=Shop+%26+co&enabled=false`)
    expect(commitUrl({ mode: 'existing', sourceId: SOURCE.id, label: '', enabled: true }, 'b'.repeat(64)))
      .toBe(`/api/outcomes/csv-imports/commit?sha256=${'b'.repeat(64)}&source=${SOURCE.id}`)
  })
})

describe('CSV import preview', () => {
  it('shows the counts and the rows, keeping not-known apart from zero', () => {
    const html = renderToStaticMarkup(<CsvImportPreview preview={preview()} />)
    for (const text of ['3 rows', '1 new', '1 changed', '1 unchanged', '0 invalid']) expect(html).toContain(text)
    expect(html).toContain('<caption')
    expect(html).toContain('>New<')
    expect(html).toContain('>Changed<')
    expect(html).toContain('>Unchanged<')
    expect(html).toContain('aria-label="not known"')
    expect(html).toMatch(/<td[^>]*>0<\/td>/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('lists row errors by row and column in an announced region', () => {
    const html = renderToStaticMarkup(<CsvImportPreview preview={preview({
      counts: { total: 3, new: 2, changed: 0, unchanged: 0, invalid: 1 },
      errors: [{ row: 4, field: 'status', code: 'invalid_choice', message: 'This value is not one of the allowed choices.' },
        { row: 4, field: null, code: 'column_count', message: 'This row has a different number of cells than the header.' }],
    })} />)
    const alert = html.slice(html.indexOf('role="alert"'))
    expect(html).toContain('role="alert"')
    expect(alert).toContain('1 row has problems')
    expect(html).toContain('>4<')
    expect(html).toContain('status')
    expect(html).toContain('whole row')
    expect(html).toContain('This value is not one of the allowed choices.')
  })

  it('says when the error list or the row table is cut short', () => {
    const html = renderToStaticMarkup(<CsvImportPreview preview={preview({
      errors: [{ row: 9, field: 'status', code: 'invalid_choice', message: 'm' }], errors_truncated: true, rows_truncated: true,
    })} />)
    expect(html).toContain('first 500 problems')
    expect(html).toContain('first 200 rows')
  })
})
