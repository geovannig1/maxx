'use client'

import { Download } from 'lucide-react'
import { buildCsv } from '@/lib/export/csv'

// Reusable "Export CSV" button. `getData` is called on click so it reads the table's CURRENT
// state (sort / filter / visible columns) — you export exactly what you see.
export function ExportCsvButton({
  filename,
  getData,
  disabled,
}: {
  filename: string
  getData: () => { headers: string[]; rows: Array<Array<string | number | null | undefined>> }
  disabled?: boolean
}) {
  function handleExport() {
    const { headers, rows } = getData()
    const csv = buildCsv(headers, rows)
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }) // BOM → Excel reads UTF-8
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <button
      onClick={handleExport}
      disabled={disabled}
      className="flex items-center gap-1.5 rounded-lg text-xs transition-colors disabled:opacity-40"
      style={{
        height: 32, padding: '0 12px',
        background: 'var(--bg-input)',
        border: '1px solid var(--border)',
        color: 'var(--text-secondary)',
      }}
    >
      <Download className="w-3.5 h-3.5" />
      Export
    </button>
  )
}
