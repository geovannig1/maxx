/**
 * Validates EVERY stored paid-cohort row against the REAL reader schemas and reports every distinct
 * failure at once — npx tsx --tsconfig tsconfig.scripts.json scripts/audit-paid-cohort-rows.ts
 *
 * Written because the alternative keeps failing: re-deriving a schema by hand in SQL produces wrong
 * diagnoses. A hand-written restatement of a Zod schema is a second implementation that can disagree
 * with the first. This imports the
 * schemas the reader actually uses.
 *
 * It reports the whole population rather than stopping at the first bad row, so "what else is broken"
 * is answered in one pass instead of one deploy at a time.
 */
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { createClient } from '@supabase/supabase-js'
import { PAID_COHORT_DIAGNOSTIC_SCHEMAS } from '../src/lib/attribution/paid-cohort-reader'

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const GEN_COLS = 'id, evaluation_run_id, cohort_kind, window_start, window_end, as_of_date, activation_id, contract_version, policy_version, account_spend, landing_page_views, captured_landing_views, complete, blocker_codes, metrics, created_at'
const UNIT_COLS = 'id, generation_id, entity_level, entity_id, spend, landing_page_views, captured_touches, bookings, booked_value, complete, blocker_codes, metrics'

async function page(table: string, columns: string) {
  const rows: Record<string, unknown>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(columns).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    if (!data?.length) break
    rows.push(...(data as unknown as Record<string, unknown>[]))
    if (data.length < 1000) break
  }
  return rows
}

function audit(label: string, rows: Record<string, unknown>[], schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }) {
  const byIssue = new Map<string, { count: number; sample: unknown }>()
  let bad = 0
  for (const row of rows) {
    const parsed = schema.safeParse(row)
    if (parsed.success) continue
    bad++
    for (const issue of parsed.error!.issues) {
      const key = `${issue.path.join('.') || '<root>'}: ${issue.message}`
      const entry = byIssue.get(key) ?? { count: 0, sample: undefined }
      entry.count++
      if (entry.sample === undefined) {
        entry.sample = issue.path.length === 1
          ? row[String(issue.path[0])]
          : issue.path.length === 2
            ? (row[String(issue.path[0])] as Record<string, unknown> | null)?.[String(issue.path[1])]
            : '(nested)'
      }
      byIssue.set(key, entry)
    }
  }
  console.log(`\n${label}: ${rows.length} rows, ${bad} rejected`)
  if (byIssue.size === 0) { console.log('  no schema failures'); return bad }
  for (const [issue, { count, sample }] of [...byIssue].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(count).padStart(4)}×  ${issue}   e.g. ${JSON.stringify(sample)}`)
  }
  return bad
}

async function main() {
  const generations = await page('paid_cohort_generations', GEN_COLS)
  const units = await page('paid_cohort_units', UNIT_COLS)
  const badGen = audit('paid_cohort_generations', generations, PAID_COHORT_DIAGNOSTIC_SCHEMAS.generation)
  const badUnit = audit('paid_cohort_units', units, PAID_COHORT_DIAGNOSTIC_SCHEMAS.unit)

  // The reader only ever validates the LATEST evaluation run, so that pair is what actually gates the
  // pipeline. Reported separately from the historical backlog, which is never read.
  const latest = [...generations]
    .filter((g) => g.cohort_kind === 'recent_scale')
    .sort((a, b) => String(b.as_of_date).localeCompare(String(a.as_of_date))
      || String(b.created_at).localeCompare(String(a.created_at)))[0]
  if (latest) {
    const runId = latest.evaluation_run_id
    const inRun = generations.filter((g) => g.evaluation_run_id === runId)
    const runUnits = units.filter((u) => inRun.some((g) => g.id === u.generation_id))
    console.log(`\n── the pair the reader actually gates on (run ${runId}) ──`)
    audit('  generations in latest run', inRun, PAID_COHORT_DIAGNOSTIC_SCHEMAS.generation)
    audit('  units in latest run', runUnits, PAID_COHORT_DIAGNOSTIC_SCHEMAS.unit)
  }
  console.log(`\ntotals: ${badGen} generation(s) and ${badUnit} unit(s) rejected across all history`)
}

main().catch((e) => { console.error(e); process.exit(1) })
