'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Download, FileCheck2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CSV_COLUMNS, CSV_TEMPLATE, MAX_CSV_BYTES, MAX_CSV_ROWS } from '@/lib/outcomes/adapters/csv/contract'
import { CsvImportPreview, type CsvPreviewBody } from './CsvImportPreview'

export interface CsvSourceOption {
  id: string
  label: string
  enabled: boolean
  lastSuccessAt: string | null
}

export interface CsvDestination {
  mode: 'existing' | 'new'
  sourceId: string
  label: string
  enabled: boolean
}

const API = '/api/outcomes/csv-imports'

export function previewUrl(d: CsvDestination): string {
  const q = new URLSearchParams()
  if (d.mode === 'existing') q.set('source', d.sourceId)
  else if (d.label.trim()) q.set('label', d.label.trim())
  const query = q.toString()
  return `${API}/preview${query ? `?${query}` : ''}`
}

export function commitUrl(d: CsvDestination, sha256: string): string {
  const q = new URLSearchParams({ sha256 })
  if (d.mode === 'existing') q.set('source', d.sourceId)
  else {
    q.set('label', d.label.trim())
    q.set('enabled', String(d.enabled))
  }
  return `${API}/commit?${q.toString()}`
}

type Done = { counts: CsvPreviewBody['counts'] }

async function failure(res: Response): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: string; file_error?: { message?: string; row?: number | null } } | null
  if (body?.file_error?.message) return body.file_error.row ? `Row ${body.file_error.row}: ${body.file_error.message}` : body.file_error.message
  return body?.error ?? `The request failed (${res.status}).`
}

export function CsvImportPanel({ sources }: { sources: CsvSourceOption[] }) {
  const router = useRouter()
  const [dest, setDest] = useState<CsvDestination>({
    mode: sources.length > 0 ? 'existing' : 'new', sourceId: sources[0]?.id ?? '', label: '', enabled: true,
  })
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<CsvPreviewBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [done, setDone] = useState<Done | null>(null)
  const text = useRef<string>('')

  const reset = () => { setPreview(null); setError(null); setDone(null) }
  const update = (patch: Partial<CsvDestination>) => { setDest((d) => ({ ...d, ...patch })); reset() }
  const labelMissing = dest.mode === 'new' && dest.label.trim() === ''
  const writes = preview ? preview.counts.new + preview.counts.changed : 0
  const canCommit = !!preview && preview.counts.invalid === 0 && writes > 0 && !labelMissing && busy === null

  async function runPreview() {
    if (!file) return setError('Choose a CSV file first.')
    if (file.size > MAX_CSV_BYTES) return setError(`The file is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB. Split it into smaller files.`)
    reset()
    setBusy('preview')
    try {
      text.current = await file.text()
      const res = await fetch(previewUrl(dest), { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text.current })
      if (!res.ok) setError(await failure(res))
      else setPreview(await res.json() as CsvPreviewBody)
    } catch {
      setError('The file could not be sent. Check your connection and try again.')
    } finally {
      setBusy(null)
    }
  }

  async function runCommit() {
    if (!preview || !canCommit) return
    setBusy('commit')
    setError(null)
    try {
      const res = await fetch(commitUrl(dest, preview.file.sha256), {
        method: 'POST', headers: { 'content-type': 'text/csv' }, body: text.current,
      })
      if (!res.ok) return setError(await failure(res))
      const body = await res.json() as { source_id: string; counts: CsvPreviewBody['counts'] }
      setDone({ counts: body.counts })
      setPreview(null)
      setDest((d) => ({ ...d, mode: 'existing', sourceId: body.source_id }))
      router.refresh()
    } catch {
      setError('The import could not be sent. Check your connection and try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-3">
        <legend className="section-label mb-2">Import into</legend>
        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="csv-destination" checked={dest.mode === 'existing'} onChange={() => update({ mode: 'existing' })} />
              An existing CSV source
            </label>
            <label htmlFor="csv-source" className="sr-only">CSV source</label>
            <select
              id="csv-source"
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
              value={dest.sourceId}
              disabled={dest.mode !== 'existing'}
              onChange={(e) => update({ sourceId: e.target.value })}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.label}{s.enabled ? '' : ' (not counted in reports)'}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {sources.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="csv-destination" checked={dest.mode === 'new'} onChange={() => update({ mode: 'new' })} />
              A new CSV source
            </label>
          )}
          {dest.mode === 'new' && (
            <div className="flex flex-col gap-2 pl-0 sm:pl-6">
              <label htmlFor="csv-source-label" className="text-sm font-medium">Source name</label>
              <Input
                id="csv-source-label"
                maxLength={128}
                value={dest.label}
                aria-describedby="csv-source-label-hint"
                aria-invalid={preview !== null && labelMissing ? true : undefined}
                onChange={(e) => update({ label: e.target.value })}
                placeholder="e.g. Shop orders"
              />
              <p id="csv-source-label-hint" className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                A name for where these results come from. Required to import.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={dest.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
                Count this source&apos;s outcomes in reports
              </label>
            </div>
          )}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor="csv-file" className="text-sm font-medium">CSV file</label>
        <input
          id="csv-file"
          type="file"
          accept=".csv,text/csv"
          aria-describedby={error ? 'csv-file-hint csv-import-error' : 'csv-file-hint'}
          aria-invalid={error ? true : undefined}
          className="text-sm"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); reset() }}
        />
        <p id="csv-file-hint" className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {`Comma separated, UTF-8, header in the first row. Up to ${MAX_CSV_BYTES / 1024 / 1024} MB and ${MAX_CSV_ROWS.toLocaleString('en-US')} rows. Nothing is saved until you import.`}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={runPreview} disabled={busy !== null}>
            <FileCheck2 aria-hidden="true" />
            {busy === 'preview' ? 'Checking…' : 'Preview'}
          </Button>
          <Button type="button" onClick={runCommit} disabled={!canCommit}>
            <Upload aria-hidden="true" />
            {busy === 'commit' ? 'Importing…' : `Import ${writes.toLocaleString('en-US')} row${writes === 1 ? '' : 's'}`}
          </Button>
          <a
            className="inline-flex items-center gap-1.5 text-sm underline-offset-4 hover:underline"
            style={{ color: 'var(--accent)' }}
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`}
            download="maxx-outcomes-template.csv"
          >
            <Download className="size-4" aria-hidden="true" />
            Download a sample CSV
          </a>
        </div>
      </div>

      <div aria-live="polite" role="status" className="text-sm">
        {done && `Imported: ${done.counts.new} new, ${done.counts.changed} changed, ${done.counts.unchanged} unchanged.`}
        {preview && writes === 0 && preview.counts.invalid === 0 && 'Everything in this file is already imported; there is nothing to change.'}
        {preview && labelMissing && 'Enter a source name to import.'}
      </div>
      {error && <p id="csv-import-error" role="alert" className="owner-notice owner-warning">{error}</p>}

      {preview && <CsvImportPreview preview={preview} />}

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">CSV columns</summary>
        <table className="mt-3 w-full text-left text-xs">
          <caption className="sr-only">CSV column reference</caption>
          <thead><tr><th scope="col" className="py-1 pr-3">Column</th><th scope="col" className="py-1 pr-3">Required</th><th scope="col" className="py-1">Meaning</th></tr></thead>
          <tbody>
            {CSV_COLUMNS.map((c) => (
              <tr key={c.name} className="align-top">
                <td className="py-1 pr-3"><code>{c.name}</code></td>
                <td className="py-1 pr-3">{c.required ? 'Required' : 'Optional'}</td>
                <td className="py-1" style={{ color: 'var(--text-secondary)' }}>{c.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}
