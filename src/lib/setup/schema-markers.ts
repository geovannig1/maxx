// Whether the schema is applied, as seen through the Supabase REST API (no database password needed).
// Each marker is a table the shipped schema creates. The doctor reads PostgREST's OpenAPI description
// with the service-role key and reports the first missing marker table as "apply the schema". Markers
// name tables, never migration files: v1 ships one baseline (supabase/migrations/0001_baseline.sql), and
// tests/setup-schema-markers.test.ts fails when a migration that creates tables has none of them here,
// so a later migration cannot ship invisible to the doctor. Changes that only alter or replace objects
// cannot be seen this way; they ship in order with the ones that can.

/** Marker tables, in the order the schema introduces them. */
export const SCHEMA_MARKER_TABLES: readonly string[] = [
  'ad_accounts',
  'outcome_sources',
  'outcome_source_secrets',
  'expert_insight_judge_attempts',
  'outcome_csv_imports',
]

/** Marker tables absent from the OpenAPI `paths`, in order; all of them when the description is unreadable. */
export function missingMarkers(openApi: unknown): string[] {
  const paths = (openApi as { paths?: Record<string, unknown> } | null)?.paths
  if (!paths || typeof paths !== 'object') return [...SCHEMA_MARKER_TABLES]
  return SCHEMA_MARKER_TABLES.filter((table) => !Object.hasOwn(paths, `/${table}`))
}
