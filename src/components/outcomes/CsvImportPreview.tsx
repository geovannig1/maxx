import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

/** The body of POST /api/outcomes/csv-imports/preview (src/lib/outcomes/adapters/csv/owner-route.ts). */
export interface CsvPreviewBody {
  ok: true
  file: { sha256: string; bytes: number }
  timezone: string
  counts: { total: number; new: number; changed: number; unchanged: number; invalid: number }
  errors: Array<{ row: number; field: string | null; code: string; message: string }>
  errors_truncated: boolean
  rows: Array<{
    row: number
    status: 'new' | 'changed' | 'unchanged'
    external_id: string
    outcome_type: string
    outcome_status: string
    occurred_at: string
    currency: string
    gross_value: string | null
    collected_value: string | null
    origin: string
    outcome_label: string | null
  }>
  rows_truncated: boolean
}

const STATUS_LABEL = { new: 'New', changed: 'Changed', unchanged: 'Unchanged' } as const
const STATUS_COLOR = { new: 'var(--accent)', changed: 'var(--warning)', unchanged: 'var(--text-tertiary)' } as const

/** Not known is shown as a dash with an accessible name, never as 0. */
function Value({ value }: { value: string | null }) {
  return value === null ? <span aria-label="not known">—</span> : <>{value}</>
}

const n = (value: number) => value.toLocaleString('en-US')

function plural(count: number, word: string): string {
  return `${n(count)} ${word}${count === 1 ? '' : 's'}`
}

export function CsvImportPreview({ preview }: { preview: CsvPreviewBody }) {
  const { counts } = preview
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm" style={{ color: 'var(--text-secondary)' }} data-testid="csv-counts">
        {`${plural(counts.total, 'row')}: ${n(counts.new)} new, ${n(counts.changed)} changed, ${n(counts.unchanged)} unchanged, `
          + `${n(counts.invalid)} invalid. Dates without a time are read in ${preview.timezone}.`}
      </p>

      {preview.errors.length > 0 && (
        <section aria-labelledby="csv-errors-title" className="flex flex-col gap-2">
          <div role="alert" className="owner-notice owner-warning">
            <span id="csv-errors-title" className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              {counts.invalid === 1 ? '1 row has problems.' : `${n(counts.invalid)} rows have problems.`}
            </span>
            Fix them in your spreadsheet and preview the file again. Nothing is imported while any row has a problem.
          </div>
          <Table>
            <TableCaption>
              Problems by spreadsheet row (the header is row 1)
              {preview.errors_truncated ? '. Showing the first 500 problems.' : '.'}
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Row</TableHead>
                <TableHead scope="col">Column</TableHead>
                <TableHead scope="col">Problem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.errors.map((error, i) => (
                <TableRow key={`${error.row}-${error.field ?? 'row'}-${i}`}>
                  <TableCell>{error.row}</TableCell>
                  <TableCell><code>{error.field ?? 'whole row'}</code></TableCell>
                  <TableCell className="whitespace-normal">{error.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}

      {preview.rows.length > 0 && (
        <Table>
          <TableCaption>
            Valid rows as they will be imported{preview.rows_truncated ? '. Showing the first 200 rows.' : '.'}
          </TableCaption>
          <TableHeader>
            <TableRow>
              {['Row', 'Import', 'External id', 'Type', 'Status', 'Occurred (UTC)', 'Gross', 'Collected', 'Origin', 'Label']
                .map((h) => <TableHead key={h} scope="col">{h}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.rows.map((r) => (
              <TableRow key={r.row}>
                <TableCell>{r.row}</TableCell>
                <TableCell style={{ color: STATUS_COLOR[r.status], fontWeight: 600 }}>{STATUS_LABEL[r.status]}</TableCell>
                <TableCell><code>{r.external_id}</code></TableCell>
                <TableCell>{r.outcome_type}</TableCell>
                <TableCell>{r.outcome_status}</TableCell>
                <TableCell>{r.occurred_at.replace('T', ' ').replace(/\.000Z$/, 'Z')}</TableCell>
                <TableCell className="tabular-nums"><Value value={r.gross_value} /></TableCell>
                <TableCell className="tabular-nums"><Value value={r.collected_value} /></TableCell>
                <TableCell>{r.origin}</TableCell>
                <TableCell><Value value={r.outcome_label} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
