import fs from 'node:fs'
import path from 'node:path'

// The single source of the snapshot-URL allowlist is the database CHECK competitor_ads_snapshot_url_no_token
// in the shipped schema (supabase/migrations). Tests read it from there so the application redactor and
// the database CHECK cannot drift apart.
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'supabase/migrations')

/** Concatenated SQL of every shipped migration. */
export function shippedSchemaSql(): string {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).join('\n')
}

/**
 * The allowlist pattern, taken from the CHECK (`ad_snapshot_url ~ '...'`). Exactly one case-sensitive,
 * anchored literal must exist; anything else throws so a test fails rather than passing against a
 * pattern the database does not enforce.
 */
export function snapshotUrlAllowlist(sql: string = shippedSchemaSql()): RegExp {
  const literals = [...sql.replace(/^--.*$/gm, '').matchAll(/ad_snapshot_url\s+(!?~\*?)\s+'([^']+)'/g)]
  if (literals.length !== 1 || literals[0][1] !== '~') {
    throw new Error(`snapshot allowlist: expected one '~' CHECK literal, found ${JSON.stringify(literals.map(([m]) => m))}`)
  }
  const source = literals[0][2]
  if (!source.startsWith('^') || !source.endsWith('$')) throw new Error('snapshot allowlist must be anchored')
  return new RegExp(source)
}
