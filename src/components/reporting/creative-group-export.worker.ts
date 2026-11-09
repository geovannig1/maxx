import { buildCreativeGroupCsv } from '@/lib/reporting/creative-group-export'
import type { CreativeGroupingResult } from '@/lib/reporting/creative-groups'
import type { ReportingContext } from '@/lib/reporting/contracts'

export interface CreativeExportRequest { result: CreativeGroupingResult; context: ReportingContext; keys: readonly string[] }
export type CreativeExportResponse = { ok: true; blob: Blob } | { ok: false }

// The existing full-evidence check stays intact. Serialization runs off the browser's main thread.
self.onmessage = (event: MessageEvent<CreativeExportRequest>) => {
  try {
    const { result, context, keys } = event.data
    const csv = buildCreativeGroupCsv(result, context, keys)
    self.postMessage({ ok: true, blob: new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }) } satisfies CreativeExportResponse)
  } catch { self.postMessage({ ok: false } satisfies CreativeExportResponse) }
}
