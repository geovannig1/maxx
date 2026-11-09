'use client'

import { Printer } from 'lucide-react'

// Triggers the browser's print dialog → "Save as PDF" gives a clean client deliverable. Hidden in the
// printed output itself via the .no-print class.
export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="no-print inline-flex items-center gap-2 rounded-lg font-semibold"
      style={{ height: 34, padding: '0 14px', fontSize: 13, background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', cursor: 'pointer' }}
    >
      <Printer style={{ width: 15, height: 15 }} />
      Print / Save as PDF
    </button>
  )
}
