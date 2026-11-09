'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import type { CreativeGroupingResult } from '@/lib/reporting/creative-groups'
import type { ReportingContext } from '@/lib/reporting/contracts'
import { META_NATIVE_METRIC_DEFINITIONS, META_RATIO_METRIC_DEFINITIONS } from '@/lib/reporting/meta-metric-definitions'
import type { CreativeExportRequest, CreativeExportResponse } from './creative-group-export.worker'
import { reportButtonClass } from './MetricTable'

const ALL_KEYS = [...META_NATIVE_METRIC_DEFINITIONS.map(metric => metric.key), ...META_RATIO_METRIC_DEFINITIONS.map(metric => metric[0])]
const EXPORT_TIMEOUT_MS = 60_000
type ExportState = { result: CreativeGroupingResult; context: ReportingContext; status: 'working' | 'failed' | 'complete' | 'cancelled' }

export function CreativeGroupExport({ result, context }: { result: CreativeGroupingResult; context: ReportingContext }) {
  const [state, setState] = useState<ExportState | null>(null)
  const active = useRef<{ stop: () => void } | null>(null)
  const releaseDownload = useRef<(() => void) | null>(null)
  const status = state?.result === result && state?.context === context ? state.status : null
  // Cancel at commit, before a queued message from the old selection can download stale evidence.
  useLayoutEffect(() => () => {
    active.current?.stop()
    releaseDownload.current?.()
    releaseDownload.current = null
  }, [result, context])

  function start() {
    active.current?.stop()
    setState({ result, context, status: 'working' })
    let worker: Worker | null = null, timer: ReturnType<typeof setTimeout> | undefined
    const task = { stop() {
      if (timer) clearTimeout(timer)
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); worker = null }
      if (active.current === task) active.current = null
    } }
    active.current = task
    const fail = () => {
      if (active.current !== task) return
      task.stop(); setState({ result, context, status: 'failed' })
    }
    try {
      worker = new Worker(new URL('./creative-group-export.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<CreativeExportResponse>) => {
        if (active.current !== task) return
        if (!event.data?.ok || !(event.data.blob instanceof Blob)) { fail(); return }
        task.stop()
        try {
          releaseDownload.current?.()
          const url = URL.createObjectURL(event.data.blob)
          const releaseTimer = setTimeout(() => { URL.revokeObjectURL(url); releaseDownload.current = null }, 1000)
          releaseDownload.current = () => { clearTimeout(releaseTimer); URL.revokeObjectURL(url) }
          const link = document.createElement('a')
          link.href = url
          link.download = `maxx-creative-evidence-${context.range.from}-${context.range.to}.csv`
          link.click()
          setState({ result, context, status: 'complete' })
        } catch { setState({ result, context, status: 'failed' }) }
      }
      worker.onerror = fail; worker.onmessageerror = fail
      timer = setTimeout(fail, EXPORT_TIMEOUT_MS)
      worker.postMessage({ result, context, keys: ALL_KEYS } satisfies CreativeExportRequest)
    } catch { fail() }
  }
  return <div className="space-y-2 print:hidden">
    <div className="flex flex-wrap gap-2">
      <button type="button" className={reportButtonClass} onClick={start} disabled={status === 'working'}>Export all group evidence</button>
      {status === 'working' && <button type="button" className={reportButtonClass} onClick={() => {
        active.current?.stop(); setState({ result, context, status: 'cancelled' })
      }}>Cancel export</button>}
    </div>
    <p className="max-w-2xl text-xs leading-5 text-[var(--text-secondary)]">All supported metrics, selected executions and native evidence; independent of the visible metric tab.</p>
    <p role="status" aria-live="polite" className="text-xs text-[var(--text-secondary)]">{status === 'working' ? 'Preparing evidence. You can keep reading or cancel.'
      : status === 'failed' ? 'The evidence export could not be prepared. Try again or open individual ad results.'
        : status === 'complete' ? 'Evidence download prepared.' : status === 'cancelled' ? 'Export cancelled.' : ''}</p>
  </div>
}
