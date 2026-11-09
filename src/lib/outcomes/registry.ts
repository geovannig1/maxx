import type { OutcomeSourceAdapter } from './adapter'
import { acuityAdapter } from './adapters/acuity/adapter'
import { csvAdapter } from './adapters/csv/adapter'
import { webhookAdapter } from './adapters/webhook/adapter'

// Outcome source adapters by `outcome_sources.kind`.
const ADAPTERS: ReadonlyMap<string, OutcomeSourceAdapter> = new Map([
  [acuityAdapter.kind, acuityAdapter],
  [csvAdapter.kind, csvAdapter],
  [webhookAdapter.kind, webhookAdapter],
])

export function getOutcomeAdapter(kind: string): OutcomeSourceAdapter | null {
  return ADAPTERS.get(kind) ?? null
}

export function listOutcomeAdapters(): OutcomeSourceAdapter[] {
  return [...ADAPTERS.values()]
}
