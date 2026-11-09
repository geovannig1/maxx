export const dynamic = 'force-dynamic'

import { FileSpreadsheet } from 'lucide-react'
import { requireOwner } from '@/lib/auth/page-owner'
import { getAdminClient } from '@/lib/supabase/admin'
import { activeAccountErrorCode, resolveOnlyActiveAccount } from '@/lib/accounts/active-account'
import { listCsvSources, type CsvSourceSummary } from '@/lib/outcomes/adapters/csv/import'
import { PageHeader } from '@/components/layout/PageHeader'
import { StatePanel } from '@/components/ui/state-panel'
import { CsvImportPanel } from '@/components/outcomes/CsvImportPanel'
import { outcomeWords } from '@/config/outcome-nouns'

// What this business calls its outcomes (NEXT_PUBLIC_OUTCOME_NOUN).
const OW = outcomeWords()

// /settings/outcomes/import — owner only. Upload a CSV of business outcomes, preview every row, then
// import. The routes behind it are /api/outcomes/csv-imports/{preview,commit}.

type SourcesState = { ok: true; sources: CsvSourceSummary[] } | { ok: false; code: string }

async function readSources(): Promise<SourcesState> {
  try {
    const db = getAdminClient()
    const active = await resolveOnlyActiveAccount(db)
    if (!active.ok) return { ok: false, code: activeAccountErrorCode(active.reason) }
    return { ok: true, sources: await listCsvSources(db, active.account.id) }
  } catch {
    return { ok: false, code: 'CSV_SOURCES_UNAVAILABLE' }
  }
}

export default async function CsvOutcomeImportPage() {
  await requireOwner()
  const state = await readSources()

  return (
    <div className="owner-page owner-page-narrow">
      <div className="owner-surface owner-surface-section">
        <PageHeader
          title="Import outcomes from CSV"
          icon={FileSpreadsheet}
          subtitle={`Bring in leads, sales or ${OW.many} from any system that can export a spreadsheet. Importing the same file again changes nothing; a changed row updates its outcome.`}
        />
      </div>

      <div className="owner-notice">
        CSV outcomes count as business results, but a file cannot carry the ad-click token, so they never link to a
        specific ad and are never sent to an ad platform. While a CSV source is counted, paid cohorts stay marked
        incomplete.
      </div>

      <div className="owner-surface owner-surface-section">
        {state.ok ? (
          <CsvImportPanel sources={state.sources} />
        ) : (
          <StatePanel
            state="unavailable"
            compact
            title="CSV sources unavailable"
            description={`The account's outcome sources could not be read (${state.code}).`}
          />
        )}
      </div>
    </div>
  )
}
